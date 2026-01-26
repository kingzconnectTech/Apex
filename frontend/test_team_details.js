
const fetch = globalThis.fetch;

const BASE_URL = 'http://site.api.espn.com/apis/site/v2/sports';

// Copied from espn.js
const fetchTeamDetails = async (sport, league, teamId) => {
  try {
    console.log(`Fetching: ${BASE_URL}/${sport}/${league}/teams/${teamId}/schedule`);
    
    // Parallel fetch for efficiency
    const [teamResponse, newsResponse, scheduleResponse] = await Promise.all([
      fetch(`${BASE_URL}/${sport}/${league}/teams/${teamId}`),
      fetch(`${BASE_URL}/${sport}/${league}/news?limit=5`),
      fetch(`${BASE_URL}/${sport}/${league}/teams/${teamId}/schedule`)
    ]);

    const teamData = await teamResponse.json();
    const newsData = await newsResponse.json();
    const scheduleData = await scheduleResponse.json();

    const team = teamData.team;
    
    // Process Form (Last 5 matches)
    const events = scheduleData.events || [];
    console.log(`Found ${events.length} total events in schedule.`);
    
    const completedEvents = events.filter(e => e.competitions[0].status.type.state === 'post');
    console.log(`Found ${completedEvents.length} completed events.`);
    
    const last5 = completedEvents.slice(-5).reverse(); // Most recent first
    
    const form = last5.map(event => {
      const competition = event.competitions[0];
      const competitor = competition.competitors.find(c => String(c.team.id) === String(teamId));
      const outcome = competitor?.winner ? 'W' : (competition.status.type.description === 'Draw' ? 'D' : 'L'); // Simplified
      return outcome;
    });

    return {
      info: {
        id: team.id,
        name: team.displayName,
        abbreviation: team.abbreviation,
        color: team.color,
        logo: team.logos?.[0]?.href,
        standingSummary: team.standingSummary, // "3rd in Premier League"
      },
      nextMatch: team.nextEvent ? {
        name: team.nextEvent[0].name,
        date: team.nextEvent[0].date,
        id: team.nextEvent[0].id
      } : null,
      lastMatches: last5.map(e => {
        const competition = e.competitions[0];
        const teamComp = competition.competitors.find(c => String(c.team.id) === String(teamId));
        const oppComp = competition.competitors.find(c => String(c.team.id) !== String(teamId));
        
        return {
          date: e.date,
          name: e.name,
          score: `${teamComp?.score?.value}-${oppComp?.score?.value}`,
          pf: parseInt(teamComp?.score?.value || 0),
          pa: parseInt(oppComp?.score?.value || 0),
          isHome: teamComp?.homeAway === 'home',
          result: teamComp?.winner ? 'W' : 'L/D',
          opponentId: oppComp?.team?.id
        };
      }),
      news: (newsData.articles || []).map(article => ({
        headline: article.headline,
        description: article.description,
        link: article.links?.web?.href,
        published: article.published,
      })),
      stats: {
        rank: team.rank,
        record: team.record?.items?.[0]?.summary,
        formString: form.join('-'),
      }
    };
  } catch (error) {
    console.error('Error fetching team details:', error);
    return null;
  }
};

async function test() {
  console.log("Testing fetchTeamDetails for Man City (eng.1)...");
  const details = await fetchTeamDetails('soccer', 'eng.1', '382');
  console.log("Result lastMatches count:", details?.lastMatches?.length);
  if (details?.lastMatches?.length > 0) {
      console.log("Sample Match:", details.lastMatches[0]);
  }
}

test();