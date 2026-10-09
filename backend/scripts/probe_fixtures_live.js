process.on('unhandledRejection', (err) => { console.error('UNHANDLED:', err && err.message ? err.message : err); process.exit(1); });
const path = require('path');
const fs = require('fs');
const dotenvPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(dotenvPath)) require('dotenv').config({ path: dotenvPath });
const { ApiFootballProvider } = require('../services/providers/ApiFootballProvider');
const { ESPNProvider } = require('../services/providers/EspnProvider');
const { SportsDataService } = require('../services/SportsDataService');

const LOGGER = { log: (lvl, msg) => { if (lvl === 'debug') return; console.log(`[${lvl.toUpperCase()}] ${msg}`); } };

(async () => {
  const af = new ApiFootballProvider({ logger: LOGGER });
  const season = 2024; // Free plan accessible season
  console.log('Using season=', season, '(free-plan accessible; CURRENT_SEASON remains 2026 per spec)');

  // 1. Find Eng Premier League (league id=39 in API-Football)
  const leagueId = 39;
  console.log('\n--- Find candidate fixtures in league=', leagueId, 'season=', season, '---');
  const from = '2024-08-01';
  const to = '2025-05-31';
  const allInRange = await af.getFixtures({ league: leagueId, season, from, to, traceId: 'probe-range' }).catch(() => []);
  console.log(`Fixtures in ${season} league=${leagueId} range=${from}..${to}: count=${allInRange.length}`);

  const finished = allInRange.filter(f => f && f.status && ['FT','AET','PEN','Finished'].includes(f.status));
  console.log(`Finished fixtures (FT/AET/PEN): ${finished.length}`);
  const fx = finished[Math.floor(finished.length / 2)] || finished[0] || allInRange[0];
  if (!fx) { console.log('[ABORT] no fixtures found'); return; }
  console.log(`Chosen fixtureId=${fx.fixtureId}  date=${fx.date}  status=${fx.status}`);
  console.log(`  home=af-${fx.homeTeam.sourceId}:${fx.homeTeam.name}  away=af-${fx.awayTeam.sourceId}:${fx.awayTeam.name}`);
  console.log(`  league=af-${fx.league.sourceId}:${fx.league.name}  (country=${fx.league.country})`);

  // 2. Individual provider methods called by getMatchDataForPrediction
  console.log('\n--- Individual AF method probes ---');
  const homeId = String(fx.homeTeam.sourceId);
  const awayId = String(fx.awayTeam.sourceId);
  const fxId = String(fx.fixtureId).startsWith('af-') ? String(fx.fixtureId).slice(3) : String(fx.fixtureId);
  const lgId = String(fx.league.sourceId).startsWith('af-') ? String(fx.league.sourceId).slice(3) : String(fx.league.sourceId);

  const byId = await af.getFixtureById(fxId, { traceId: 'probe-id' });
  console.log('getFixtureById:', byId ? `OK date=${byId.date} status=${byId.status}` : 'null');

  const homeSchedule = await af.getFixtures({ team: homeId, season, from: '2024-07-01', to: fx.date?.slice(0,10) || to, traceId: 'probe-hist' });
  console.log(`getFixtures(team=${homeId}) count=${homeSchedule.length} (home history before fixture date)`);

  const awaySchedule = await af.getFixtures({ team: awayId, season, from: '2024-07-01', to: fx.date?.slice(0,10) || to, traceId: 'probe-away' });
  console.log(`getFixtures(team=${awayId}) count=${awaySchedule.length}`);

  const homeStats = await af.getTeamStatistics({ league: lgId, season, team: homeId, traceId: 'probe-hstats' });
  console.log(`getTeamStatistics(home ${homeId}):`, homeStats ? `form=${homeStats.form || '?'} record=${homeStats.recordSummary || '?'}` : 'null');

  const awayStats = await af.getTeamStatistics({ league: lgId, season, team: awayId, traceId: 'probe-astats' });
  console.log(`getTeamStatistics(away ${awayId}):`, awayStats ? `form=${awayStats.form || '?'} record=${awayStats.recordSummary || '?'}` : 'null');

  const h2h = await af.getHeadToHead({ h2h: `${homeId}-${awayId}`, last: 5, traceId: 'probe-h2h' });
  console.log(`getHeadToHead(${homeId}-${awayId}): W/D/L=${h2h.homeWins}/${h2h.draws}/${h2h.awayWins} matches=${Array.isArray(h2h.matches) ? h2h.matches.length : 0}`);

  // 3. Now call the full getMatchDataForPrediction chain via SportsDataService
  console.log('\n--- Full SportsDataService.getMatchDataForPrediction chain ---');
  const svc = new SportsDataService({
    logger: LOGGER,
    espnProvider: new ESPNProvider({ logger: LOGGER }),
    apiFootballProvider: af,
  });
  const matchId = String(fx.fixtureId).startsWith('af-') ? String(fx.fixtureId) : `af-${fx.fixtureId}`;
  const homeTeamId = String(fx.homeTeam.sourceId).startsWith('af-') ? String(fx.homeTeam.sourceId) : `af-${fx.homeTeam.sourceId}`;
  const awayTeamId = String(fx.awayTeam.sourceId).startsWith('af-') ? String(fx.awayTeam.sourceId) : `af-${fx.awayTeam.sourceId}`;
  const leagueSlug = `af-${lgId}`;
  const res = await svc.getMatchDataForPrediction({
    matchId, sport: 'soccer', leagueSlug, homeTeamId, awayTeamId, traceId: 'probe-full',
  });
  const keys = Object.keys(res || {}).sort().join(',');
  console.log('Result top-level keys:', keys);
  console.log('  source =', res?.source);
  console.log('  tried  =', JSON.stringify(res?.tried));
  console.log('  homeName =', res?.homeName, '; awayName =', res?.awayName);
  console.log('  homeRecord =', res?.homeRecord, '; awayRecord =', res?.awayRecord);
  console.log('  homeLastMatches.length =', Array.isArray(res?.homeLastMatches) ? res.homeLastMatches.length : 'N/A');
  console.log('  awayLastMatches.length =', Array.isArray(res?.awayLastMatches) ? res.awayLastMatches.length : 'N/A');
  console.log('  h2h W/D/L =', res?.h2h ? `${res.h2h.homeWins}/${res.h2h.draws}/${res.h2h.awayWins}` : 'N/A');
  console.log('  h2h.matches.length =', res?.h2h && Array.isArray(res.h2h.matches) ? res.h2h.matches.length : 'N/A');
  if (Array.isArray(res?.homeLastMatches) && res.homeLastMatches.length > 0) {
    const m0 = res.homeLastMatches[0];
    console.log('  homeLastMatches[0] shape:', Object.keys(m0).sort().join(','));
    console.log('    =', JSON.stringify(m0));
  }
  // Shape rubric against the mocked test (Task 4.1): tried array, source, names non-null, lastMatches have 6 keys each, h2h 4 keys.
  const rubric = {
    source_nonnull: Boolean(res?.source),
    tried_has_espn_first: Array.isArray(res?.tried) && res.tried[0] === 'espn',
    names_strings: typeof res?.homeName === 'string' && typeof res?.homeName === 'string' && res.homeName.length > 0 && res.awayName.length > 0,
    homeLastMatches_each_has_6_keys: Array.isArray(res?.homeLastMatches) && (res.homeLastMatches.length === 0 || res.homeLastMatches.every(m => Object.keys(m).length >= 6)),
    h2h_shape: Boolean(res?.h2h) && typeof res.h2h.homeWins === 'number' && typeof res.h2h.draws === 'number' && typeof res.h2h.awayWins === 'number' && Array.isArray(res.h2h.matches),
  };
  console.log('\nRubric vs mocked Task 4.1 expected-shape:', JSON.stringify(rubric, null, 2));
  const rubricScore = Object.values(rubric).filter(Boolean).length + '/' + Object.keys(rubric).length;
  console.log('Rubric score:', rubricScore);
})();
