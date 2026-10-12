import { API_URL } from '../constants/config';

const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';
const PROXY_BASE = `${API_URL}/api/proxy?target=`;

// Simple client-side cache with TTL
const clientCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

// Top leagues & lower divisions to fetch for fast multi-division coverage
const TOP_LEAGUES = [
  // Soccer - Top Tier Leagues
  { sport: 'soccer', league: 'eng.1', name: 'Premier League' },
  { sport: 'soccer', league: 'esp.1', name: 'La Liga' },
  { sport: 'soccer', league: 'ita.1', name: 'Serie A' },
  { sport: 'soccer', league: 'ger.1', name: 'Bundesliga' },
  { sport: 'soccer', league: 'fra.1', name: 'Ligue 1' },
  { sport: 'soccer', league: 'uefa.champions', name: 'Champions League' },
  { sport: 'soccer', league: 'uefa.europa', name: 'Europa League' },
  // Soccer - Lower Division Leagues
  { sport: 'soccer', league: 'eng.2', name: 'Championship' },
  { sport: 'soccer', league: 'eng.3', name: 'League One' },
  { sport: 'soccer', league: 'eng.4', name: 'League Two' },
  { sport: 'soccer', league: 'esp.2', name: 'La Liga 2' },
  { sport: 'soccer', league: 'ita.2', name: 'Serie B' },
  { sport: 'soccer', league: 'ger.2', name: '2. Bundesliga' },
  { sport: 'soccer', league: 'fra.2', name: 'Ligue 2' },
  { sport: 'soccer', league: 'ned.2', name: 'Eerste Divisie' },
  { sport: 'soccer', league: 'por.2', name: 'Liga Portugal 2' },
  { sport: 'soccer', league: 'sct.2', name: 'Scottish Championship' },
  { sport: 'soccer', league: 'bra.2', name: 'Brasileirão Série B' },
  { sport: 'soccer', league: 'mex.2', name: 'Liga de Expansión MX' },
  { sport: 'soccer', league: 'usa.2', name: 'USL Championship' },
  { sport: 'soccer', league: 'jpn.2', name: 'J2 League' },
  // Basketball - NBA/WNBA
  { sport: 'basketball', league: 'nba', name: 'NBA' },
  { sport: 'basketball', league: 'wnba', name: 'WNBA' },
  // Tennis - Top Tours
  { sport: 'tennis', league: 'atp', name: 'ATP Tour' },
  { sport: 'tennis', league: 'wta', name: 'WTA Tour' },
  { sport: 'tennis', league: 'grand-slam', name: 'Grand Slams' },
];

// All leagues for later use
const ALL_LEAGUES = [
  // Soccer
  { sport: 'soccer', league: 'eng.1', name: 'Premier League' },
  { sport: 'soccer', league: 'eng.2', name: 'Championship' },
  { sport: 'soccer', league: 'eng.3', name: 'League One' },
  { sport: 'soccer', league: 'eng.4', name: 'League Two' },
  { sport: 'soccer', league: 'esp.1', name: 'La Liga' },
  { sport: 'soccer', league: 'esp.2', name: 'La Liga 2' },
  { sport: 'soccer', league: 'ita.1', name: 'Serie A' },
  { sport: 'soccer', league: 'ita.2', name: 'Serie B' },
  { sport: 'soccer', league: 'ger.1', name: 'Bundesliga' },
  { sport: 'soccer', league: 'ger.2', name: '2. Bundesliga' },
  { sport: 'soccer', league: 'fra.1', name: 'Ligue 1' },
  { sport: 'soccer', league: 'fra.2', name: 'Ligue 2' },
  { sport: 'soccer', league: 'ned.1', name: 'Eredivisie' },
  { sport: 'soccer', league: 'ned.2', name: 'Eerste Divisie' },
  { sport: 'soccer', league: 'por.1', name: 'Liga Portugal' },
  { sport: 'soccer', league: 'por.2', name: 'Liga Portugal 2' },
  { sport: 'soccer', league: 'tur.1', name: 'Super Lig' },
  { sport: 'soccer', league: 'rus.1', name: 'Russian Premier League' },
  { sport: 'soccer', league: 'ukr.1', name: 'Ukrainian Premier League' },
  { sport: 'soccer', league: 'bel.1', name: 'Belgian Pro League' },
  { sport: 'soccer', league: 'sct.1', name: 'Scottish Premiership' },
  { sport: 'soccer', league: 'sct.2', name: 'Scottish Championship' },
  { sport: 'soccer', league: 'aut.1', name: 'Austrian Bundesliga' },
  { sport: 'soccer', league: 'grc.1', name: 'Super League Greece' },
  { sport: 'soccer', league: 'dnk.1', name: 'Danish Superliga' },
  { sport: 'soccer', league: 'swe.1', name: 'Allsvenskan' },
  { sport: 'soccer', league: 'nor.1', name: 'Eliteserien' },
  { sport: 'soccer', league: 'cze.1', name: 'Czech First League' },
  { sport: 'soccer', league: 'hun.1', name: 'Nemzeti Bajnokság I' },
  { sport: 'soccer', league: 'pol.1', name: 'Ekstraklasa' },
  { sport: 'soccer', league: 'mex.1', name: 'Liga MX' },
  { sport: 'soccer', league: 'mex.2', name: 'Liga de Expansión MX' },
  { sport: 'soccer', league: 'bra.1', name: 'Brasileirão Série A' },
  { sport: 'soccer', league: 'bra.2', name: 'Brasileirão Série B' },
  { sport: 'soccer', league: 'arg.1', name: 'Argentine Primera División' },
  { sport: 'soccer', league: 'chl.1', name: 'Chilean Primera División' },
  { sport: 'soccer', league: 'col.1', name: 'Categoría Primera A' },
  { sport: 'soccer', league: 'per.1', name: 'Peruvian Liga 1' },
  { sport: 'soccer', league: 'uru.1', name: 'Uruguayan Primera División' },
  { sport: 'soccer', league: 'usa.1', name: 'MLS' },
  { sport: 'soccer', league: 'usa.2', name: 'USL Championship' },
  { sport: 'soccer', league: 'usa.nwsl', name: 'NWSL' },
  { sport: 'soccer', league: 'can.1', name: 'Canadian Premier League' },
  { sport: 'soccer', league: 'jpn.1', name: 'J1 League' },
  { sport: 'soccer', league: 'jpn.2', name: 'J2 League' },
  { sport: 'soccer', league: 'kor.1', name: 'K League 1' },
  { sport: 'soccer', league: 'chn.1', name: 'Chinese Super League' },
  { sport: 'soccer', league: 'aus.1', name: 'A-League Men' },
  { sport: 'soccer', league: 'aus.2', name: 'A-League Women' },
  { sport: 'soccer', league: 'saudi.1', name: 'Saudi Pro League' },
  { sport: 'soccer', league: 'uae.1', name: 'UAE Pro League' },
  { sport: 'soccer', league: 'qat.1', name: 'Qatar Stars League' },
  { sport: 'soccer', league: 'egy.1', name: 'Egyptian Premier League' },
  { sport: 'soccer', league: 'ngr.1', name: 'Nigerian Professional Football League' },
  { sport: 'soccer', league: 'conmebol.libertadores', name: 'Copa Libertadores' },
  { sport: 'soccer', league: 'conmebol.sudamericana', name: 'Copa Sudamericana' },
  { sport: 'soccer', league: 'conmebol.copaamerica', name: 'Copa America' },
  { sport: 'soccer', league: 'concacaf.goldcup', name: 'Gold Cup' },
  { sport: 'soccer', league: 'concacaf.champions', name: 'CONCACAF Champions Cup' },
  { sport: 'soccer', league: 'concacaf.nationsleague', name: 'CONCACAF Nations League' },
  { sport: 'soccer', league: 'uefa.champions', name: 'Champions League' },
  { sport: 'soccer', league: 'uefa.europa', name: 'Europa League' },
  { sport: 'soccer', league: 'uefa.europaconference', name: 'Europa Conference League' },
  { sport: 'soccer', league: 'uefa.nations', name: 'Nations League' },
  { sport: 'soccer', league: 'uefa.euro', name: 'UEFA European Championship' },
  { sport: 'soccer', league: 'uefa.womenseuro', name: 'UEFA Women\'s Championship' },
  { sport: 'soccer', league: 'fifa.world', name: 'FIFA World Cup' },
  { sport: 'soccer', league: 'fifa.womens-world-cup', name: 'FIFA Women\'s World Cup' },
  { sport: 'soccer', league: 'fifa.friendly', name: 'International Friendlies' },
  
  // Basketball
  { sport: 'basketball', league: 'nba', name: 'NBA' },
  { sport: 'basketball', league: 'nba-g-league', name: 'NBA G League' },
  { sport: 'basketball', league: 'wnba', name: 'WNBA' },
  { sport: 'basketball', league: 'mens-college-basketball', name: 'NCAA Men' },
  { sport: 'basketball', league: 'womens-college-basketball', name: 'NCAA Women' },
  { sport: 'basketball', league: 'euroleague', name: 'EuroLeague' },
  { sport: 'basketball', league: 'eurocup', name: 'EuroCup' },
  { sport: 'basketball', league: 'eurochamp', name: 'FIBA EuroBasket' },
  { sport: 'basketball', league: 'fibawc', name: 'FIBA Basketball World Cup' },
  { sport: 'basketball', league: 'acb', name: 'Liga ACB (Spain)' },
  { sport: 'basketball', league: 'legabasket', name: 'Lega Basket Serie A (Italy)' },
  { sport: 'basketball', league: 'bbl', name: 'Basketball Bundesliga (Germany)' },
  { sport: 'basketball', league: 'betclic', name: 'Betclic Élite (France)' },
  { sport: 'basketball', league: 'australia.nbl', name: 'NBL Australia' },
  { sport: 'basketball', league: 'cba', name: 'CBA (China)' },
  { sport: 'basketball', league: 'bcl', name: 'Basketball Champions League' },
  { sport: 'basketball', league: 'nbca', name: 'NBA Summer League' },
  
  // Tennis
  { sport: 'tennis', league: 'grand-slam', name: 'Grand Slams' },
  { sport: 'tennis', league: 'atp', name: 'ATP Tour' },
  { sport: 'tennis', league: 'atp.masters', name: 'ATP Masters 1000' },
  { sport: 'tennis', league: 'atp.500', name: 'ATP 500' },
  { sport: 'tennis', league: 'atp.250', name: 'ATP 250' },
  { sport: 'tennis', league: 'atp.challenger', name: 'ATP Challenger Tour' },
  { sport: 'tennis', league: 'atp.finals', name: 'ATP Finals' },
  { sport: 'tennis', league: 'wta', name: 'WTA Tour' },
  { sport: 'tennis', league: 'wta.premier', name: 'WTA Premier' },
  { sport: 'tennis', league: 'wta.1000', name: 'WTA 1000' },
  { sport: 'tennis', league: 'wta.500', name: 'WTA 500' },
  { sport: 'tennis', league: 'wta.250', name: 'WTA 250' },
  { sport: 'tennis', league: 'wta.125', name: 'WTA 125' },
  { sport: 'tennis', league: 'wta.finals', name: 'WTA Finals' },
  { sport: 'tennis', league: 'itf', name: 'ITF Tour' },
  { sport: 'tennis', league: 'davis-cup', name: 'Davis Cup' },
  { sport: 'tennis', league: 'billie-jean-king-cup', name: 'Billie Jean King Cup' },
  { sport: 'tennis', league: 'laver-cup', name: 'Laver Cup' },
  { sport: 'tennis', league: 'hopman-cup', name: 'Hopman Cup' },
  { sport: 'tennis', league: 'next-gen-atp-finals', name: 'Next Gen ATP Finals' },
];

const getFromClientCache = (key) => {
  const cached = clientCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    clientCache.delete(key);
    return null;
  }
  return cached.data;
};

const setToClientCache = (key, data) => {
  clientCache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS
  });
};

const fetchFromBackendOrESPN = async (relativePath) => {
  const cacheKey = relativePath;
  const cached = getFromClientCache(cacheKey);
  if (cached) {
    return cached;
  }

  // Try backend proxy first (uses server-side cache)
  try {
    const proxyResp = await fetch(`${PROXY_BASE}${encodeURIComponent(relativePath)}`);
    if (proxyResp.ok) {
      const data = await proxyResp.json();
      setToClientCache(cacheKey, data);
      return data;
    }
  } catch (e) {
    // Fall through to ESPN
  }

  // Fallback to ESPN directly
  try {
    const espnResp = await fetch(`${BASE_URL}/${relativePath}`);
    const data = await espnResp.json();
    setToClientCache(cacheKey, data);
    return data;
  } catch (e) {
    console.error('Failed to fetch from both backend and ESPN:', e);
    throw e;
  }
};

export const fetchMatches = async (useTopLeaguesOnly = true, days = 1) => {
  try {
    const leagues = useTopLeaguesOnly ? TOP_LEAGUES : ALL_LEAGUES;
    
    // 1. Fetch only current scoreboard (no extra days for speed)
    const promises = leagues.map(async ({ sport, league, name }) => {
      try {
        const data = await fetchFromBackendOrESPN(`${sport}/${league}/scoreboard`);
        return processEvents(data.events || [], sport, league, name);
      } catch (error) {
        console.warn(`Failed to fetch default for ${name}:`, error);
        return [];
      }
    });

    // Execute all fetches
    const results = await Promise.all(promises);
    
    // Flatten and Dedupe
    const allMatchesRaw = results.flat();
    const seenIds = new Set();
    const allMatches = allMatchesRaw.filter(match => {
      if (seenIds.has(match.id)) return false;
      seenIds.add(match.id);
      return true;
    }).sort((a, b) => a.date - b.date);
    
    // Split into Live and Upcoming
    const live = allMatches.filter(match => match.status === 'in');
    const upcoming = allMatches.filter(match => match.status === 'pre');
    const completed = allMatches.filter(match => match.status === 'post');

    return { live, upcoming, completed, all: allMatches };

  } catch (error) {
    console.error('Error fetching matches:', error);
    return { live: [], upcoming: [] };
  }
};

/**
 * Fetch matches for a specific league on-demand (works for ESPN and PitchAPI).
 */
export const fetchLeagueMatches = async (leagueSlug, sport = 'soccer', name = '') => {
  try {
    const data = await fetchFromBackendOrESPN(`${sport}/${leagueSlug}/scoreboard`);
    return processEvents(data.events || [], sport, leagueSlug, name || leagueSlug);
  } catch (error) {
    console.warn(`Failed to fetch matches for ${name || leagueSlug}:`, error);
    return [];
  }
};

// Helper to process events (DRY)
const processEvents = (events, sport, league, name) => {
  return events.map(event => {
    const competition = event.competitions?.[0];
    if (!competition) return null;
    
    const competitors = competition.competitors || [];
    let homeCompetitor, awayCompetitor;
    
    if (sport === 'tennis') {
      // For tennis, just take first two competitors (order may vary)
      homeCompetitor = competitors[0];
      awayCompetitor = competitors[1];
    } else {
      homeCompetitor = competitors.find(c => c.homeAway === 'home');
      awayCompetitor = competitors.find(c => c.homeAway === 'away');
    }
    
    return {
      id: event.id,
      league: name,
      sport: sport,
      leagueSlug: league,
      date: new Date(event.date),
      status: event.status?.type?.state || 'pre', // pre, in, post
      clock: event.status?.displayClock,
      period: event.status?.period,
      homeTeam: {
        id: homeCompetitor?.team?.id,
        name: homeCompetitor?.team?.displayName,
        logo: homeCompetitor?.team?.logo,
        score: homeCompetitor?.score,
        record: homeCompetitor?.records?.[0]?.summary,
        form: homeCompetitor?.form,
      },
      awayTeam: {
        id: awayCompetitor?.team?.id,
        name: awayCompetitor?.team?.displayName,
        logo: awayCompetitor?.team?.logo,
        score: awayCompetitor?.score,
        record: awayCompetitor?.records?.[0]?.summary,
        form: awayCompetitor?.form,
      },
      time: event.status?.type?.shortDetail || '',
    };
  }).filter(Boolean);
};

// Fetch comprehensive team details
export const fetchTeamDetails = async (sport, league, teamId) => {
  try {
    // Parallel fetch for efficiency
    const [teamData, newsData, scheduleData] = await Promise.all([
      fetchFromBackendOrESPN(`${sport}/${league}/teams/${teamId}`),
      fetchFromBackendOrESPN(`${sport}/${league}/news?team=${teamId}&limit=5`),
      fetchFromBackendOrESPN(`${sport}/${league}/teams/${teamId}/schedule`),
    ]);

    const team = teamData.team;
    
    // Process Form (Last 5 matches, including live ones)
    const events = scheduleData.events || [];
    const validEvents = events.filter(e => {
      const state = e.competitions?.[0]?.status?.type?.state;
      return state === 'post' || state === 'in';
    });
    const last5 = validEvents.slice(-5).reverse(); // Most recent first
    
    const form = last5.map(event => {
      const competition = event.competitions?.[0];
      if (!competition) return '-';
      const teamComp = competition.competitors?.find(c => String(c?.team?.id) === String(teamId));
      const oppComp = competition.competitors?.find(c => String(c?.team?.id) !== String(teamId));
      
      if (!teamComp || !oppComp) return '-';
      
      // Parse scores — score may be a string or object with .value
      const teamScore = parseInt(teamComp.score?.value ?? teamComp.score ?? 0);
      const oppScore = parseInt(oppComp.score?.value ?? oppComp.score ?? 0);
      const state = competition.status?.type?.state;
      
      if (state === 'in') return 'LIVE';
      
      if (teamScore > oppScore) return 'W';
      if (teamScore < oppScore) return 'L';
      return 'D';
    });

    return {
      info: {
        id: team?.id,
        name: team?.displayName,
        abbreviation: team?.abbreviation,
        color: team?.color,
        logo: team?.logos?.[0]?.href,
        standingSummary: team?.standingSummary,
      },
      nextMatch: (team?.nextEvent && team.nextEvent.length > 0) ? {
        name: team.nextEvent[0].name,
        date: team.nextEvent[0].date,
        id: team.nextEvent[0].id
      } : null,
      lastMatches: last5.map(e => {
        const competition = e.competitions?.[0];
        if (!competition) return null;
        const teamComp = competition.competitors?.find(c => String(c?.team?.id) === String(teamId));
        const oppComp = competition.competitors?.find(c => String(c?.team?.id) !== String(teamId));
        if (!teamComp || !oppComp) return null;

        const pf = parseInt(teamComp?.score?.value ?? teamComp?.score ?? 0);
        const pa = parseInt(oppComp?.score?.value ?? oppComp?.score ?? 0);
        const state = competition.status?.type?.state;
        let result;
        if (state === 'in') result = 'D';
        else if (pf > pa) result = 'W';
        else if (pf < pa) result = 'L';
        else result = 'D';
        
        return {
          date: e.date,
          name: e.name,
          score: `${pf}-${pa}`,
          pf,
          pa,
          isHome: teamComp?.homeAway === 'home',
          result,
          opponentId: oppComp?.team?.id
        };
      }).filter(Boolean),
      news: (newsData.articles || []).map(article => ({
        headline: article.headline,
        description: article.description,
        link: article.links?.web?.href,
        published: article.published,
      })),
      stats: {
        rank: team?.rank,
        record: team?.record?.items?.[0]?.summary,
        formString: form.join('-'),
      }
    };
  } catch (error) {
    console.error('Error fetching team details:', error);
    return null;
  }
};

// Fetch Match Analysis (Boxscore, stats)
export const fetchMatchAnalysis = async (sport, league, matchId) => {
  try {
    const data = await fetchFromBackendOrESPN(`${sport}/${league}/summary?event=${matchId}`);

    const boxscore = data.boxscore;
    const header = data.header;
    const stats = boxscore?.teams || []; // Team stats

    // Helper to find specific stat
    const findStat = (teamIndex, statName) => {
      const teamStats = stats[teamIndex]?.statistics || [];
      const stat = teamStats.find(s => s.name === statName || s.label === statName);
      return stat ? stat.displayValue : '0';
    };

    // Advanced Stats Extraction
    const getStats = (teamIndex) => {
      const s = stats[teamIndex]?.statistics || [];
      const getValue = (key) => {
        const item = s.find(i => i.name === key || i.label === key);
        return item ? parseFloat(item.displayValue) : 0;
      };
      
      // Basketball Specific
      const fga = getValue('fieldGoalsAttempted');
      const fgm = getValue('fieldGoalsMade');
      const fta = getValue('freeThrowsAttempted');
      const orb = getValue('offensiveRebounds');
      const tov = getValue('turnovers');
      const pts = getValue('points') || (stats[teamIndex]?.score ? parseFloat(stats[teamIndex].score) : 0);
      const assists = getValue('assists');
      const threePm = getValue('threePointFieldGoalsMade');
      const threePa = getValue('threePointFieldGoalsAttempted');
      
      // Soccer Specific
      const shotsOnTarget = getValue('shotsOnGoal');
      const totalPasses = getValue('totalPasses');
      const passPct = getValue('completionPct');
      const saves = getValue('saves');
      
      return { fga, fgm, fta, orb, tov, pts, assists, threePm, threePa, shotsOnTarget, totalPasses, passPct, saves };
    };

    const homeAdvanced = getStats(0);
    const awayAdvanced = getStats(1);

    // Normalize H2H Games from ESPN's actual 'seasonseries' field.
    // 'headToHeadGames' does not exist in the ESPN summary API.
    // 'seasonseries' is an array of past meetings between the two teams.
    // Each entry has: id, date, competitors[{homeAway, team{id}, score, winner}]
    let h2hGames = [];
    const rawSeries = data.seasonseries || [];
    if (rawSeries.length > 0) {
      h2hGames = rawSeries.map(event => {
        const homeComp = event.competitors?.find(c => c.homeAway === 'home');
        const awayComp = event.competitors?.find(c => c.homeAway === 'away');
        if (!homeComp || !awayComp) return null;
        const homeScore = parseInt(homeComp.score ?? 0);
        const awayScore = parseInt(awayComp.score ?? 0);
        return {
          id: event.id,
          gameDate: event.date,
          homeTeamId: homeComp.team?.id,
          awayTeamId: awayComp.team?.id,
          homeTeamScore: String(homeScore),
          awayTeamScore: String(awayScore),
          score: `${homeScore}-${awayScore}`,
        };
      }).filter(Boolean);
      // Deduplicate by id
      h2hGames = [...new Map(h2hGames.map(item => [item.id, item])).values()];
    }

    return {
      matchInfo: {
        venue: data.gameInfo?.venue?.fullName,
        attendance: data.gameInfo?.attendance,
      },
      headToHeadGames: h2hGames,
      homeStats: {
        possession: findStat(0, 'possessionPct'),
        shots: findStat(0, 'shots'),
        fouls: findStat(0, 'foulsCommitted'),
        corners: findStat(0, 'wonCorners'),
        fgPct: findStat(0, 'fieldGoalPct'),
        rebounds: findStat(0, 'totalRebounds'),
        ...homeAdvanced
      },
      awayStats: {
        possession: findStat(1, 'possessionPct'),
        shots: findStat(1, 'shots'),
        fouls: findStat(1, 'foulsCommitted'),
        corners: findStat(1, 'wonCorners'),
        fgPct: findStat(1, 'fieldGoalPct'),
        rebounds: findStat(1, 'totalRebounds'),
        ...awayAdvanced
      },
      standings: data.standings,
      rosters: data.rosters || [],
    };
  } catch (error) {
    console.error('Error fetching match analysis:', error);
    return null;
  }
};

// Fetch simplified stats for a list of match IDs
export const fetchGamesStats = async (sport, league, gameIds) => {
  if (!gameIds || gameIds.length === 0) return [];
  
  const promises = gameIds.map(async (id) => {
    try {
      const data = await fetchFromBackendOrESPN(`${sport}/${league}/summary?event=${id}`);
      const stats = data.boxscore?.teams || [];
      
      const findStat = (teamStats, statName) => {
        const s = teamStats?.statistics?.find(i => i.name === statName || i.label === statName);
        return s ? parseFloat(s.displayValue) : 0;
      };

      return {
        id,
        homeId: data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.id,
        awayId: data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.id,
        homeStats: {
            corners: findStat(stats[0], 'wonCorners'),
            yellowCards: findStat(stats[0], 'yellowCards'),
            redCards: findStat(stats[0], 'redCards'),
            fouls: findStat(stats[0], 'foulsCommitted'),
        },
        awayStats: {
            corners: findStat(stats[1], 'wonCorners'),
            yellowCards: findStat(stats[1], 'yellowCards'),
            redCards: findStat(stats[1], 'redCards'),
            fouls: findStat(stats[1], 'foulsCommitted'),
        }
      };
    } catch (e) {
      console.warn(`Failed to fetch stats for game ${id}`, e);
      return null;
    }
  });

  const results = await Promise.all(promises);
  return results.filter(r => r !== null);
};
