import { API_URL } from '../constants/config';

const BASE_URL = 'https://site.api.espn.com/apis/site/v2/sports';
const PROXY_BASE = `${API_URL}/api/proxy?target=`;

const withCacheBuster = (url) => {
  const ts = Date.now();
  return url + (url.includes('?') ? `&_=${ts}` : `?_=${ts}`);
};

const fetchFromBackendOrESPN = async (relativePath) => {
  // Try backend proxy first (uses server-side cache)
  try {
    const proxyResp = await fetch(`${PROXY_BASE}${encodeURIComponent(relativePath)}`);
    if (proxyResp.ok) {
      return await proxyResp.json();
    }
  } catch (e) {
    // Fall through to ESPN
  }
  // Fallback to ESPN directly with cache-buster to avoid CDN staleness
  const espnResp = await fetch(withCacheBuster(`${BASE_URL}/${relativePath}`));
  return await espnResp.json();
};

const LEAGUES = [
  // Soccer
  { sport: 'soccer', league: 'eng.1', name: 'Premier League' },
  { sport: 'soccer', league: 'eng.2', name: 'Championship' },
  { sport: 'soccer', league: 'eng.3', name: 'League One' },
  { sport: 'soccer', league: 'esp.1', name: 'La Liga' },
  { sport: 'soccer', league: 'esp.2', name: 'La Liga 2' },
  { sport: 'soccer', league: 'ita.1', name: 'Serie A' },
  { sport: 'soccer', league: 'ita.2', name: 'Serie B' },
  { sport: 'soccer', league: 'ger.1', name: 'Bundesliga' },
  { sport: 'soccer', league: 'ger.2', name: '2. Bundesliga' },
  { sport: 'soccer', league: 'fra.1', name: 'Ligue 1' },
  { sport: 'soccer', league: 'fra.2', name: 'Ligue 2' },
  { sport: 'soccer', league: 'ned.1', name: 'Eredivisie' },
  { sport: 'soccer', league: 'por.1', name: 'Liga Portugal' },
  { sport: 'soccer', league: 'por.2', name: 'Liga Portugal 2' },
  { sport: 'soccer', league: 'tur.1', name: 'Super Lig' },
  { sport: 'soccer', league: 'rus.1', name: 'Russian Premier League' },
  { sport: 'soccer', league: 'ukr.1', name: 'Ukrainian Premier League' },
  { sport: 'soccer', league: 'bel.1', name: 'Belgian Pro League' },
  { sport: 'soccer', league: 'sct.1', name: 'Scottish Premiership' },
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

export const fetchMatches = async (days = 3, startDate = new Date()) => {
  try {
    // 1. Fetch Default Endpoint (Live + Top/Today)
    // This ensures we get the most accurate "Live" status
    const defaultPromises = LEAGUES.map(async ({ sport, league, name }) => {
      try {
        const data = await fetchFromBackendOrESPN(`${sport}/${league}/scoreboard`);
        return processEvents(data.events || [], sport, league, name);
      } catch (error) {
        console.warn(`Failed to fetch default for ${name}:`, error);
        return [];
      }
    });

    // 2. Fetch Dates (Today + Future)
    const futureDates = [];
    for (let i = 0; i < days; i++) { // Start from today (i=0)
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      futureDates.push(`${year}${month}${day}`);
    }

    const futurePromises = LEAGUES.map(async ({ sport, league, name }) => {
      const leaguePromises = futureDates.map(async (date) => {
        try {
          const data = await fetchFromBackendOrESPN(`${sport}/${league}/scoreboard?dates=${date}`);
          return processEvents(data.events || [], sport, league, name);
        } catch (error) {
          console.warn(`Failed to fetch ${name} for ${date}:`, error);
          return [];
        }
      });
      const leagueResults = await Promise.all(leaguePromises);
      return leagueResults.flat();
    });

    // Execute all fetches
    const [defaultResults, futureResults] = await Promise.all([
      Promise.all(defaultPromises),
      Promise.all(futurePromises)
    ]);

    // Flatten and Dedupe
    const allMatchesRaw = [...defaultResults.flat(), ...futureResults.flat()];
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

// Helper to process events (DRY)
const processEvents = (events, sport, league, name) => {
  return events.map(event => {
    const competition = event.competitions[0];
    const homeCompetitor = competition.competitors.find(c => c.homeAway === 'home');
    const awayCompetitor = competition.competitors.find(c => c.homeAway === 'away');
    
    return {
      id: event.id,
      league: name,
      sport: sport,
      leagueSlug: league,
      date: new Date(event.date),
      status: event.status.type.state, // pre, in, post
      clock: event.status.displayClock,
      period: event.status.period,
      homeTeam: {
        id: homeCompetitor?.team?.id,
        name: homeCompetitor?.team?.displayName,
        logo: homeCompetitor?.team?.logo,
        score: homeCompetitor?.score,
        record: homeCompetitor?.records?.[0]?.summary,
        form: homeCompetitor?.form, // Add form if available
      },
      awayTeam: {
        id: awayCompetitor?.team?.id,
        name: awayCompetitor?.team?.displayName,
        logo: awayCompetitor?.team?.logo,
        score: awayCompetitor?.score,
        record: awayCompetitor?.records?.[0]?.summary,
        form: awayCompetitor?.form, // Add form if available
      },
      time: event.status.type.shortDetail,
    };
  });
};

// Fetch comprehensive team details
export const fetchTeamDetails = async (sport, league, teamId) => {
  try {
    // Parallel fetch for efficiency (via backend proxy with fallback)
    // We use directly ESPN endpoints with cache-buster for schedule to ensure we get the latest results
    const [teamData, newsData, scheduleData] = await Promise.all([
      fetchFromBackendOrESPN(`${sport}/${league}/teams/${teamId}`),
      fetchFromBackendOrESPN(`${sport}/${league}/news?team=${teamId}&limit=5`),
      fetch(`${BASE_URL}/${sport}/${league}/teams/${teamId}/schedule?_=${Date.now()}`).then(res => res.json())
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
      
      const teamScore = parseInt(teamComp.score?.value || 0);
      const oppScore = parseInt(oppComp.score?.value || 0);
      const state = competition.status?.type?.state;
      
      if (state === 'in') return 'LIVE'; // Or just exclude it if desired
      
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
        standingSummary: team?.standingSummary, // "3rd in Premier League"
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
        
        return {
          date: e.date,
          name: e.name,
          score: `${teamComp?.score?.value || 0}-${oppComp?.score?.value || 0}`,
          pf: parseInt(teamComp?.score?.value || 0),
          pa: parseInt(oppComp?.score?.value || 0),
          isHome: teamComp?.homeAway === 'home',
          result: teamComp?.winner ? 'W' : 'L/D',
          opponentId: oppComp?.team?.id
        };
      }).filter(Boolean),
      news: (newsData.articles || []).map(article => ({
        headline: article.headline,
        description: article.description,
        link: article.links?.web?.href,
        published: article.published,
      })), // Note: This might be league-wide news if team filtering isn't perfect on public API
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

    // Normalize H2H Games (handle nested events structure)
    let h2hGames = data.headToHeadGames || [];
    if (h2hGames.length > 0 && h2hGames[0].events) {
        h2hGames = h2hGames.flatMap(item => item.events || []);
        // Deduplicate by ID just in case
        h2hGames = [...new Map(h2hGames.map(item => [item.id, item])).values()];
    }

    return {
      matchInfo: {
        venue: data.gameInfo?.venue?.fullName,
        attendance: data.gameInfo?.attendance,
      },
      headToHeadGames: h2hGames,
      homeStats: {
        possession: findStat(0, 'possessionPct'), // Soccer
        shots: findStat(0, 'shots'), // Soccer
        fouls: findStat(0, 'foulsCommitted'),
        corners: findStat(0, 'wonCorners'), // Soccer
        fgPct: findStat(0, 'fieldGoalPct'), // Basketball
        rebounds: findStat(0, 'totalRebounds'), // Basketball
        // Advanced Raw Data
        ...homeAdvanced
      },
      awayStats: {
        possession: findStat(1, 'possessionPct'),
        shots: findStat(1, 'shots'),
        fouls: findStat(1, 'foulsCommitted'),
        corners: findStat(1, 'wonCorners'),
        fgPct: findStat(1, 'fieldGoalPct'),
        rebounds: findStat(1, 'totalRebounds'),
        // Advanced Raw Data
        ...awayAdvanced
      },
      standings: data.standings, // Sometimes included in summary
      rosters: data.rosters || [], // Lineups if available
    };
  } catch (error) {
    console.error('Error fetching match analysis:', error);
    return null;
  }
};

// Fetch simplified stats for a list of match IDs (for H2H analysis)
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

      // Summing up for the match (Total Cards/Corners) or just returning arrays
      // Let's return raw stats for both teams to analyze
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
