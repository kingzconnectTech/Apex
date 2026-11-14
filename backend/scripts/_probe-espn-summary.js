/* Temporary probe: verify ESPN summary payload shape for completed games. */
const BASE = 'http://site.api.espn.com/apis/site/v2/sports';

async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'apex-probe/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function summarizePlays(sport, league, eventId, summary) {
  const plays = summary?.plays || [];
  console.log(`\n=== ${sport}/${league} event=${eventId} ===`);
  console.log('summary top-level keys:', Object.keys(summary).join(', '));
  console.log('plays count:', plays.length);
  if (plays.length) {
    const p0 = plays[0];
    console.log('play[0] keys:', Object.keys(p0).join(', '));
    console.log('play[0]:', JSON.stringify({
      id: p0.id, sequenceNumber: p0.sequenceNumber, text: p0.text,
      clock: p0.clock, period: p0.period, scoringPlay: p0.scoringPlay,
      scoreValue: p0.scoreValue, awayScore: p0.awayScore, homeScore: p0.homeScore,
      type: p0.type, team: p0.team && (p0.team.id || p0.team.displayName),
    }));
    const last = plays[plays.length - 1];
    console.log('play[last]:', JSON.stringify({
      id: last.id, sequenceNumber: last.sequenceNumber, text: last.text,
      clock: last.clock, period: last.period, scoringPlay: last.scoringPlay,
      awayScore: last.awayScore, homeScore: last.homeScore, type: last.type,
    }));
    // Look for scoring plays only
    const scoring = plays.filter(p => p.scoringPlay);
    console.log('scoringPlay count:', scoring.length);
    if (scoring.length) {
      const s = scoring[0];
      console.log('scoring[0]:', JSON.stringify({
        text: s.text, clock: s.clock, period: s.period, awayScore: s.awayScore,
        homeScore: s.homeScore, scoreValue: s.scoreValue,
        teamId: s.team && s.team.id, typeText: s.type && s.type.text,
      }));
    }
  }
  const header = summary?.header;
  if (header) {
    const comp = header.competitions && header.competitions[0];
    const competitors = comp && comp.competitors;
    console.log('header status:', comp && comp.status && JSON.stringify({
      period: comp.status.period, clock: comp.status.clock, displayClock: comp.status.displayClock,
      type: comp.status.type && comp.status.type.state,
    }));
    if (competitors) {
      competitors.forEach(c => console.log('  competitor', c.homeAway, c.team && c.team.displayName, 'score', c.score && (c.score.value ?? c.score.displayValue)));
    }
  }
  const pickcenter = summary?.pickcenter || [];
  console.log('pickcenter count:', pickcenter.length);
  if (pickcenter.length) {
    console.log('pickcenter[0] keys:', Object.keys(pickcenter[0]).join(', '));
  }
}

async function main() {
  // Basketball: last completed NBA games
  const bb = await get(`${BASE}/basketball/nba/scoreboard?dates=20260410`);
  const bbEvents = bb.events || [];
  console.log('NBA events on 20260410:', bbEvents.length);
  for (const ev of bbEvents.slice(0, 1)) {
    const st = ev.competitions[0].status.type.state;
    console.log('event', ev.id, 'state', st);
    const summary = await get(`${BASE}/basketball/nba/summary?event=${ev.id}`);
    summarizePlays('basketball', 'nba', ev.id, summary);
  }

  // Soccer: last completed EPL games
  const sc = await get(`${BASE}/soccer/eng.1/scoreboard?dates=20260410`);
  const scEvents = sc.events || [];
  console.log('\nEPL events on 20260410:', scEvents.length);
  for (const ev of scEvents.slice(0, 1)) {
    const st = ev.competitions[0].status.type.state;
    console.log('event', ev.id, 'state', st);
    const summary = await get(`${BASE}/soccer/eng.1/summary?event=${ev.id}`);
    summarizePlays('soccer', 'eng.1', ev.id, summary);
  }
}

main().catch(err => { console.error('PROBE FAILED:', err.message); process.exit(1); });
