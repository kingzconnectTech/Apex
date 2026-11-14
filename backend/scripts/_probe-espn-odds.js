/* Temporary probe: pickcenter moneyline shape for basketball + soccer. */
const BASE = 'http://site.api.espn.com/apis/site/v2/sports';

async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'apex-probe/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function dumpPc(label, summary) {
  const pc = (summary.pickcenter || [])[0];
  console.log(`\n### ${label} pickcenter`);
  if (!pc) { console.log('  (none)'); return; }
  console.log('  provider:', JSON.stringify(pc.provider && pc.provider.name));
  console.log('  overUnder:', pc.overUnder, 'overOdds:', pc.overOdds, 'underOdds:', pc.underOdds);
  console.log('  spread:', pc.spread, 'pointSpread:', JSON.stringify(pc.pointSpread && pc.pointSpread.away && pc.pointSpread.away.line));
  console.log('  moneyline:', JSON.stringify(pc.moneyline));
  console.log('  homeTeamOdds:', JSON.stringify(pc.homeTeamOdds && { moneyLine: pc.homeTeamOdds.moneyLine, favorite: pc.homeTeamOdds.favorite }));
  console.log('  awayTeamOdds:', JSON.stringify(pc.awayTeamOdds && { moneyLine: pc.awayTeamOdds.moneyLine, favorite: pc.awayTeamOdds.favorite }));
  console.log('  drawOdds:', JSON.stringify(pc.drawOdds));
  console.log('  total:', JSON.stringify(pc.total));
}

async function main() {
  const bb = await get(`${BASE}/basketball/nba/scoreboard?dates=20260410`);
  const bEv = (bb.events || []).find(e => e.competitions[0].status.type.state === 'post');
  if (bEv) dumpPc(`NBA ${bEv.id}`, await get(`${BASE}/basketball/nba/summary?event=${bEv.id}`));

  const sc = await get(`${BASE}/soccer/eng.1/scoreboard?dates=20260410`);
  const sEv = (sc.events || [])[0];
  if (sEv) dumpPc(`EPL ${sEv.id}`, await get(`${BASE}/soccer/eng.1/summary?event=${sEv.id}`));

  // Check a soccer game with several goals + own goal search across a few days
  const sc2 = await get(`${BASE}/soccer/eng.1/scoreboard?dates=20260405`);
  const sEv2 = (sc2.events || []).find(e => e.competitions[0].status.type.state === 'post');
  if (sEv2) {
    const sum = await get(`${BASE}/soccer/eng.1/summary?event=${sEv2.id}`);
    const goals = (sum.keyEvents || []).filter(k => k.scoringPlay);
    console.log(`\n### EPL ${sEv2.id} goals`);
    goals.forEach(g => console.log('  ', g.clock && g.clock.displayValue, '|', g.type && g.type.text, '| team', g.team && g.team.id, '|', (g.text || '').slice(0, 80)));
  }
}

main().catch(err => { console.error('PROBE FAILED:', err.message); process.exit(1); });
