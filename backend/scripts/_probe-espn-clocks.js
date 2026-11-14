/* Temporary probe: basketball play clock display formats. */
const BASE = 'http://site.api.espn.com/apis/site/v2/sports';
async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'apex-probe/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}
async function main() {
  const bb = await get(`${BASE}/basketball/nba/scoreboard?dates=20260410`);
  const ev = (bb.events || []).find(e => e.competitions[0].status.type.state === 'post');
  const sum = await get(`${BASE}/basketball/nba/summary?event=${ev.id}`);
  const plays = sum.plays || [];
  console.log('total plays', plays.length);
  // distinct clock displayValue formats
  const set = new Set(plays.map(p => p.clock && p.clock.displayValue));
  console.log('distinct clocks (sample):', [...set].slice(0, 40).join(' | '));
  console.log('any with dot:', [...set].filter(c => c && c.includes('.')).slice(0, 20));
  console.log('any with mm:ss:', [...set].filter(c => c && c.includes(':')).length);
  // last 3 plays of period 1
  const p1 = plays.filter(p => p.period && p.period.number === 1);
  console.log('\nperiod 1 last 5 plays:');
  p1.slice(-5).forEach(p => console.log(' ', p.clock && p.clock.displayValue, '| home', p.homeScore, 'away', p.awayScore, '|', (p.text||'').slice(0,50)));
  console.log('\nperiod 1 first 3 plays:');
  p1.slice(0, 3).forEach(p => console.log(' ', p.clock && p.clock.displayValue, '| home', p.homeScore, 'away', p.awayScore));
  // Count periods
  const periods = [...new Set(plays.map(p => p.period && p.period.number))];
  console.log('\nperiods present:', periods);
}
main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
