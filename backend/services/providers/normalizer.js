const { PROVIDERS } = require('./config');

function _normalizeTeamName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bfc\b|\bcf\b|\bsc\b|\bac\b|\bif\b|\bsk\b|\bbk\b|\bafc\b/g, '')
    .trim();
}

function _normalizeDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function _dateSignature(dateObj) {
  if (!dateObj) return null;
  const d = new Date(dateObj);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function _statusFromESPNState(state) {
  if (!state) return 'scheduled';
  switch (state) {
    case 'pre': return 'scheduled';
    case 'in': return 'live';
    case 'post': return 'finished';
    default: return 'scheduled';
  }
}

function normalizeLeagueESPN(raw, sport = 'soccer', espnSlug = '') {
  if (!raw) return null;
  const league = raw.league || raw;
  return {
    sport,
    league: {
      id: espnSlug || league.slug || league.id || String(league.abbreviation || ''),
      sourceId: String(league.id || espnSlug || ''),
      name: league.name || league.shortName || espnSlug,
      abbreviation: league.abbreviation || '',
      country: '',
      season: null,
      logo: league.logos?.[0]?.href || league.logo || null,
    },
    source: PROVIDERS.ESPN,
    providerIds: { [PROVIDERS.ESPN]: espnSlug || league.slug || String(league.id || '') },
  };
}

function normalizeTeamESPN(raw, sport = 'soccer', leagueSlug = '') {
  if (!raw) return null;
  const team = raw.team || raw;
  return {
    sport,
    team: {
      id: String(team.id || ''),
      sourceId: String(team.id || ''),
      name: team.displayName || team.name || team.shortDisplayName || '',
      shortName: team.abbreviation || team.clubAbbreviation || '',
      country: '',
      logo: team.logos?.[0]?.href || team.logo || null,
    },
    league: { slug: leagueSlug },
    source: PROVIDERS.ESPN,
    providerIds: { [PROVIDERS.ESPN]: String(team.id || '') },
    normalizedName: _normalizeTeamName(team.displayName || team.name),
  };
}

function normalizeFixtureESPN(event, sport = 'soccer', leagueSlug = '', leagueDisplayName = '') {
  if (!event) return null;
  const comp = event.competitions?.[0] || {};
  const competitors = comp.competitors || [];
  let home = competitors.find(c => c.homeAway === 'home');
  let away = competitors.find(c => c.homeAway === 'away');
  if (!home && competitors[0]) home = competitors[0];
  if (!away && competitors[1]) away = competitors[1];

  const homeTeam = home?.team || {};
  const awayTeam = away?.team || {};
  const date = _normalizeDate(event.date);
  const status = comp.status?.type?.state || event.status?.type?.state || 'pre';

  return {
    sport,
    league: {
      id: leagueSlug,
      sourceId: leagueSlug,
      name: leagueDisplayName || leagueSlug,
      slug: leagueSlug,
    },
    fixture: {
      id: String(event.id || ''),
      sourceId: String(event.id || ''),
      date: date ? date.toISOString() : event.date || null,
      timestamp: date ? date.getTime() : null,
      status: _statusFromESPNState(status),
      rawStatus: comp.status?.type || event.status?.type || null,
      clock: comp.status?.displayClock || event.status?.displayClock || null,
      period: comp.status?.period || event.status?.period || 0,
      venue: comp.venue?.fullName || null,
    },
    homeTeam: {
      id: String(homeTeam.id || ''),
      sourceId: String(homeTeam.id || ''),
      name: homeTeam.displayName || homeTeam.name || '',
      logo: homeTeam.logo || homeTeam.logos?.[0]?.href || null,
      score: home?.score?.value != null ? home.score.value : null,
      record: home?.records?.[0]?.summary || null,
      form: home?.form || null,
    },
    awayTeam: {
      id: String(awayTeam.id || ''),
      sourceId: String(awayTeam.id || ''),
      name: awayTeam.displayName || awayTeam.name || '',
      logo: awayTeam.logo || awayTeam.logos?.[0]?.href || null,
      score: away?.score?.value != null ? away.score.value : null,
      record: away?.records?.[0]?.summary || null,
      form: away?.form || null,
    },
    source: PROVIDERS.ESPN,
    providerIds: { [PROVIDERS.ESPN]: String(event.id || '') },
    dedupSignature: {
      home: _normalizeTeamName(homeTeam.displayName || homeTeam.name),
      away: _normalizeTeamName(awayTeam.displayName || awayTeam.name),
      league: _normalizeTeamName(leagueDisplayName || leagueSlug),
      date: _dateSignature(date),
    },
  };
}

function normalizeStandingsESPN(raw, sport = 'soccer', leagueSlug = '') {
  if (!raw) return [];
  const entries = raw.children || raw.standings || raw.entries || [];
  const rows = [];
  const walk = (arr) => {
    arr.forEach(e => {
      if (e.entries && Array.isArray(e.entries)) walk(e.entries);
      if (e.team || e.id) {
        const stats = {};
        (e.stats || []).forEach(s => { stats[s.name || s.displayName] = s.value ?? s.displayValue; });
        rows.push({
          sport,
          league: { id: leagueSlug, slug: leagueSlug },
          team: {
            id: String(e.team?.id || e.id || ''),
            name: e.team?.displayName || e.team?.name || e.name || '',
            logo: e.team?.logo || e.team?.logos?.[0]?.href || null,
          },
          rank: e.rank || null,
          stats,
          source: PROVIDERS.ESPN,
        });
      }
    });
  };
  walk(entries);
  return rows;
}

function normalizeTeamStatsESPN(raw, teamId, sport = 'soccer') {
  return {
    teamId: String(teamId),
    source: PROVIDERS.ESPN,
    sport,
    record: raw?.team?.record?.items?.[0]?.summary || null,
    raw: raw || null,
  };
}

function _statusFromPitchAPI(status) {
  if (!status) return 'scheduled';
  const s = String(status).toLowerCase().trim();
  if (['finished', 'settled', 'ft', 'played', 'ended', 'complete', 'final',
       'aet', 'after_extra_time', 'after_penalties', 'pen', 'awarded', 'aw', 'wo', 'walkover'].includes(s)) {
    return 'finished';
  }
  if (['live', 'in_play', 'inprogress', 'in', '1h', '2h', 'ht', 'et', 'halftime',
       'first_half', 'second_half'].includes(s)) {
    return 'live';
  }
  if (['pst', 'postponed', 'delayed', 'susp', 'suspended', 'int', 'interrupted'].includes(s)) {
    return 'postponed';
  }
  if (['canc', 'cancelled', 'canceled', 'abn', 'abandoned'].includes(s)) {
    return 'cancelled';
  }
  if (['scheduled', 'not_started', 'notstarted', 'ns', 'tbd', 'pre'].includes(s)) {
    return 'scheduled';
  }
  return 'scheduled';
}

function normalizeLeaguePitchAPI(raw) {
  if (!raw) return null;
  const lg = raw.league || raw;
  return {
    sport: 'football',
    league: {
      id: lg.id ? (String(lg.id).startsWith('pa-') ? String(lg.id) : `pa-${lg.id}`) : null,
      sourceId: String(lg.id || ''),
      name: lg.name || '',
      abbreviation: '',
      country: lg.country_code || lg.country || '',
      season: lg.season || (Array.isArray(lg.seasons) && lg.seasons.length > 0 ? lg.seasons[0] : null),
      logo: lg.image_url || lg.logo || null,
    },
    source: PROVIDERS.PITCHAPI,
    providerIds: { [PROVIDERS.PITCHAPI]: String(lg.id || '') },
    seasons: lg.seasons || (lg.season ? [lg.season] : []),
    isFree: lg.is_free ?? true,
  };
}

function normalizeTeamPitchAPI(raw, leagueId = null) {
  if (!raw) return null;
  const tm = raw.team || raw;
  return {
    sport: 'football',
    team: {
      id: tm.id ? (String(tm.id).startsWith('pa-') ? String(tm.id) : `pa-${tm.id}`) : null,
      sourceId: String(tm.id || ''),
      name: tm.name || '',
      shortName: tm.short_name || '',
      country: tm.country_code || '',
      logo: tm.image_url || null,
    },
    league: { id: leagueId ? (String(leagueId).startsWith('pa-') ? String(leagueId) : `pa-${leagueId}`) : null },
    source: PROVIDERS.PITCHAPI,
    providerIds: { [PROVIDERS.PITCHAPI]: String(tm.id || '') },
    normalizedName: _normalizeTeamName(tm.name),
  };
}

function normalizeFixturePitchAPI(raw, leagueOverride = null) {
  if (!raw) return null;
  const date = _normalizeDate(raw.time_utc || raw.date);
  const league = raw.league || leagueOverride || {};
  const home = raw.home_team || raw.home || {};
  const away = raw.away_team || raw.away || {};

  const scoreHome = raw.score_home != null ? Number(raw.score_home) : null;
  const scoreAway = raw.score_away != null ? Number(raw.score_away) : null;

  let homeWinner = null;
  let awayWinner = null;
  if (scoreHome != null && scoreAway != null) {
    if (scoreHome > scoreAway) {
      homeWinner = true;
      awayWinner = false;
    } else if (scoreAway > scoreHome) {
      homeWinner = false;
      awayWinner = true;
    } else {
      homeWinner = false;
      awayWinner = false;
    }
  }

  const leagueObj = leagueOverride || league;

  return {
    sport: 'football',
    league: {
      id: leagueObj.id ? (String(leagueObj.id).startsWith('pa-') ? String(leagueObj.id) : `pa-${leagueObj.id}`) : null,
      sourceId: String(leagueObj.id || league.id || ''),
      name: leagueObj.name || league.name || '',
      country: leagueObj.country_code || leagueObj.country || league.country_code || '',
      logo: leagueObj.image_url || leagueObj.logo || league.image_url || null,
      season: leagueObj.season || league.season || null,
      round: raw.round_name || null,
    },
    fixture: {
      id: `pa-${raw.id}`,
      sourceId: String(raw.id),
      date: date ? date.toISOString() : (raw.time_utc || raw.date || null),
      timestamp: date ? date.getTime() : null,
      status: _statusFromPitchAPI(raw.status),
      rawStatus: raw.status || null,
      clock: null,
      period: 0,
      venue: raw.stadium || null,
      referee: raw.referee || null,
    },
    homeTeam: {
      id: home.id ? (String(home.id).startsWith('pa-') ? String(home.id) : `pa-${home.id}`) : null,
      sourceId: String(home.id || ''),
      name: home.name || '',
      logo: home.image_url || home.logo || null,
      score: scoreHome,
      winner: homeWinner,
    },
    awayTeam: {
      id: away.id ? (String(away.id).startsWith('pa-') ? String(away.id) : `pa-${away.id}`) : null,
      sourceId: String(away.id || ''),
      name: away.name || '',
      logo: away.image_url || away.logo || null,
      score: scoreAway,
      winner: awayWinner,
    },
    source: PROVIDERS.PITCHAPI,
    providerIds: { [PROVIDERS.PITCHAPI]: String(raw.id) },
    dedupSignature: {
      home: _normalizeTeamName(home.name),
      away: _normalizeTeamName(away.name),
      league: _normalizeTeamName(leagueObj.name || league.name),
      date: _dateSignature(date),
    },
  };
}

function normalizeH2HPitchAPI(raw, homeTeamId = null, awayTeamId = null) {
  if (!raw) return { homeWins: 0, awayWins: 0, draws: 0, matches: [], recent: [] };
  const data = raw.data || raw;
  // PitchAPI returns `recent_matches`; fall back to `h2h` for backward
  // compatibility with older/mocked payloads.
  const list = Array.isArray(data?.recent_matches)
    ? data.recent_matches
    : (Array.isArray(data?.h2h) ? data.h2h : (Array.isArray(data) ? data : []));

  // PitchAPI provides authoritative head-to-head counts at the top level of the
  // payload (home_wins / draws / away_wins). Use them when present; otherwise
  // derive from the match list to avoid fabricating data.
  const topLevelProvided = data && typeof data === 'object' && !Array.isArray(data) && (
    data.home_wins !== undefined || data.away_wins !== undefined || data.draws !== undefined
  );

  const out = {
    homeWins: topLevelProvided ? (Number(data.home_wins) || 0) : 0,
    awayWins: topLevelProvided ? (Number(data.away_wins) || 0) : 0,
    draws: topLevelProvided ? (Number(data.draws) || 0) : 0,
    matches: [],
    recent: [],
  };

  const homeClean = homeTeamId ? String(homeTeamId).replace(/^pa-/, '') : null;

  list.forEach(m => {
    const hs = m.score_home != null ? Number(m.score_home) : null;
    const as = m.score_away != null ? Number(m.score_away) : null;
    const hId = m.home?.id ? String(m.home.id).replace(/^pa-/, '') : null;
    const aId = m.away?.id ? String(m.away.id).replace(/^pa-/, '') : null;
    const date = m.time_utc || m.date || null;
    const scoreStr = (hs != null && as != null) ? `${hs}-${as}` : '?-?';

    // Only derive counts when the provider did not supply authoritative totals.
    if (!topLevelProvided && hs != null && as != null && m.finished !== false) {
      if (homeClean && hId && aId) {
        if (hId === homeClean) {
          if (hs > as) out.homeWins++;
          else if (as > hs) out.awayWins++;
          else out.draws++;
        } else if (aId === homeClean) {
          if (as > hs) out.homeWins++;
          else if (hs > as) out.awayWins++;
          else out.draws++;
        } else {
          if (hs > as) out.homeWins++;
          else if (as > hs) out.awayWins++;
          else out.draws++;
        }
      } else {
        if (hs > as) out.homeWins++;
        else if (as > hs) out.awayWins++;
        else out.draws++;
      }
    }

    out.matches.push({
      date,
      homeName: m.home?.name || '',
      awayName: m.away?.name || '',
      score: scoreStr,
    });
    out.recent.push({
      date,
      score: scoreStr,
      id: m.id || null,
    });
  });

  return out;
}

function normalizeTeamStatsPitchAPI(rawStats, teamId = null) {
  if (!rawStats) return null;
  const data = rawStats.data || rawStats;
  const periods = data?.periods || [];
  const allPeriod = periods.find(p => p.period === 'All') || periods[0];
  const groups = allPeriod?.groups || [];

  const findStat = (keyName) => {
    for (const g of groups) {
      if (Array.isArray(g.items)) {
        const item = g.items.find(i => i.key === keyName);
        if (item) return item;
      }
    }
    return null;
  };

  const xgItem = findStat('expected_goals');
  const shotsItem = findStat('shots') || findStat('total_shots');
  const cornersItem = findStat('corners') || findStat('corner_kicks');
  const yellowCardsItem = findStat('yellow_cards') || findStat('yellow_card') || findStat('yellowcards');
  const redCardsItem = findStat('red_cards') || findStat('red_card') || findStat('redcards');
  const foulsItem = findStat('fouls') || findStat('fouls_committed');

  const parseVal = (val) => {
    if (val == null) return null;
    const num = parseFloat(val);
    return isNaN(num) ? null : num;
  };

  const homeCorners = parseVal(cornersItem?.home);
  const awayCorners = parseVal(cornersItem?.away);
  const totalCorners = (homeCorners != null && awayCorners != null) ? homeCorners + awayCorners : null;

  const homeYellow = parseVal(yellowCardsItem?.home);
  const awayYellow = parseVal(yellowCardsItem?.away);
  const homeRed = parseVal(redCardsItem?.home);
  const awayRed = parseVal(redCardsItem?.away);
  const totalYellow = (homeYellow != null && awayYellow != null) ? homeYellow + awayYellow : null;
  const totalRed = (homeRed != null && awayRed != null) ? homeRed + awayRed : null;
  const totalBookings = (totalYellow != null) ? totalYellow + (totalRed || 0) : null;

  return {
    source: PROVIDERS.PITCHAPI,
    sport: 'football',
    stats: {
      homeXG: parseVal(xgItem?.home),
      awayXG: parseVal(xgItem?.away),
      homeShots: parseVal(shotsItem?.home),
      awayShots: parseVal(shotsItem?.away),
      homeCorners,
      awayCorners,
      totalCorners,
      homeYellowCards: homeYellow,
      awayYellowCards: awayYellow,
      homeRedCards: homeRed,
      awayRedCards: awayRed,
      totalYellowCards: totalYellow,
      totalRedCards: totalRed,
      totalBookings,
      homeFouls: parseVal(foulsItem?.home),
      awayFouls: parseVal(foulsItem?.away),
    },
    raw: rawStats,
  };
}

/**
 * Normalise ESPN bookmaker odds (already extracted into the internal Odds shape
 * by EspnProvider.extractBasketballOdds) into the shared Apex schema.
 */
function normalizeOddsESPN(rawOdds) {
  if (!rawOdds) return null;
  return {
    source: PROVIDERS.ESPN,
    provider: rawOdds.provider || 'espn',
    details: rawOdds.details ?? null,
    spread: rawOdds.spread ?? null,
    overUnder: rawOdds.overUnder ?? null,
    overOdds: rawOdds.overOdds ?? null,
    underOdds: rawOdds.underOdds ?? null,
    homeMoneyLine: rawOdds.homeMoneyLine ?? null,
    awayMoneyLine: rawOdds.awayMoneyLine ?? null,
    homeSpreadOdds: rawOdds.homeSpreadOdds ?? null,
    awaySpreadOdds: rawOdds.awaySpreadOdds ?? null,
    open: rawOdds.open || null,
    close: rawOdds.close || null,
    live: rawOdds.live || null,
  };
}

/**
 * Normalise an ESPN injury list into the shared Apex schema.
 * Absent injuries yield an empty array; nothing is fabricated.
 */
function normalizeInjuriesESPN(injuries) {
  if (!Array.isArray(injuries)) return [];
  return injuries.map(i => ({
    source: PROVIDERS.ESPN,
    teamId: i.teamId ?? null,
    teamName: i.teamName ?? null,
    playerId: i.playerId ?? null,
    playerName: i.playerName ?? null,
    position: i.position ?? null,
    status: i.status ?? null,
    rawStatus: i.rawStatus ?? null,
    detail: i.detail ?? null,
    injuryType: i.injuryType ?? null,
    location: i.location ?? null,
    side: i.side ?? null,
    returnDate: i.returnDate ?? null,
  }));
}

/**
 * Normalise an ESPN basketball box score into the shared Apex schema.
 * Missing stats stay null.
 */
function normalizeBasketballBoxScoreESPN(boxScore) {
  if (!boxScore) return null;
  return { source: PROVIDERS.ESPN, ...boxScore };
}

function buildDedupKey(sig) {
  if (!sig || typeof sig !== 'object') return null;
  const h = _normalizeTeamName(sig.home || '');
  const a = _normalizeTeamName(sig.away || '');
  const d = sig.date || '';
  const teams = [h, a].sort().join(':');
  return `${teams}:${d}`;
}

function fixturesMatch(fixA, fixB) {
  if (!fixA || !fixB) return false;
  const sigA = fixA.dedupSignature;
  const sigB = fixB.dedupSignature;
  if (!sigA || !sigB) return false;
  if (!sigA.date || !sigB.date) return false;
  if (sigA.date !== sigB.date) return false;

  const hA = _normalizeTeamName(sigA.home || '');
  const aA = _normalizeTeamName(sigA.away || '');
  const hB = _normalizeTeamName(sigB.home || '');
  const aB = _normalizeTeamName(sigB.away || '');

  const teamsMatch = (hA === hB && aA === aB) || (hA === aB && aA === hB);
  if (!teamsMatch) return false;

  const lA = (sigA.league || '').toLowerCase().trim();
  const lB = (sigB.league || '').toLowerCase().trim();
  if (lA && lB) {
    const leagueFuzzyMatch = lA === lB || lA.includes(lB) || lB.includes(lA);
    if (!leagueFuzzyMatch) return false;
  }

  return true;
}

module.exports = {
  _normalizeTeamName,
  _normalizeDate,
  _dateSignature,
  _statusFromPitchAPI,
  normalizeLeagueESPN,
  normalizeLeaguePitchAPI,
  normalizeTeamESPN,
  normalizeTeamPitchAPI,
  normalizeFixtureESPN,
  normalizeFixturePitchAPI,
  normalizeStandingsESPN,
  normalizeTeamStatsESPN,
  normalizeTeamStatsPitchAPI,
  normalizeH2HPitchAPI,
  normalizeOddsESPN,
  normalizeInjuriesESPN,
  normalizeBasketballBoxScoreESPN,
  buildDedupKey,
  fixturesMatch,
};
