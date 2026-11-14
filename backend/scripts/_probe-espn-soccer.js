/* Temporary probe: soccer keyEvents / commentary shape. */
const BASE = 'http://site.api.espn.com/apis/site/v2/sports';

async function get(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'apex-probe/1.0' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function main() {
  const sc = await get(`${BASE}/soccer/eng.1/scoreboard?dates=20260410`);
  const ev = (sc.events || [])[0];
  const summary = await get(`${BASE}/soccer/eng.1/summary?event=${ev.id}`);
  const key = summary.keyEvents || [];
  console.log('keyEvents count:', key.length);
  if (key.length) {
    console.log('keyEvents[0] keys:', Object.keys(key[0]).join(', '));
    console.log('keyEvents[0]:', JSON.stringify(key[0], null, 0).slice(0, 900));
    const goal = key.find(k => /goal/i.test(JSON.stringify(k.type || '')) || /goal/i.test(k.text || ''));
    console.log('\ngoal-like:', JSON.stringify(goal, null, 0).slice(0, 900));
    console.log('\nlast keyEvent:', JSON.stringify(key[key.length - 1], null, 0).slice(0, 900));
  }
  const comm = summary.commentary || [];
  console.log('\ncommentary count:', comm.length);
  if (comm.length) {
    console.log('commentary[0] keys:', Object.keys(comm[0]).join(', '));
    console.log('commentary[0]:', JSON.stringify(comm[0]).slice(0, 700));
    console.log('commentary[last]:', JSON.stringify(comm[comm.length - 1]).slice(0, 700));
  }
  // header competitors detail
  const hcomp = summary.header.competitions[0];
  console.log('\ncompetitor[0] keys:', Object.keys(hcomp.competitors[0]).join(', '));
  console.log('score obj:', JSON.stringify(hcomp.competitors[0].score));
  console.log('scoreValue:', hcomp.competitors.map(c => [c.homeAway, c.score, c.scoreValue]));
}

main().catch(err => { console.error('PROBE FAILED:', err.message); process.exit(1); });
