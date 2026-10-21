#!/usr/bin/env node
/**
 * scripts/fetch-basketball-history.js
 *
 * Fetches historical NBA game data from ESPN for backtesting.
 * Supports multiple seasons and persists to JSON for the backtester.
 *
 * Usage:
 *   node scripts/fetch-basketball-history.js --seasons=2023,2024 --out=data/nba-history.json
 *   node scripts/fetch-basketball-history.js --seasons=2024 --max-games=500
 *
 * NOTE: ESPN's scoreboard endpoint doesn't have a direct season parameter.
 * This script uses the dates parameter to fetch games by date range.
 * For a full season, you'd need to iterate through the season's date range.
 */

const fs = require('fs');
const path = require('path');
const { EspnProvider } = require('../services/providers/EspnProvider');

const ESPN_BASE_SEASON_START = {
  '2024': '2023-10-24', // 2023-24 NBA season
  '2023': '2022-10-18', // 2022-23 NBA season
  '2022': '2021-10-19', // 2021-22 NBA season
};

const ESPN_BASE_SEASON_END = {
  '2024': '2024-04-14',
  '2023': '2023-04-09',
  '2022': '2022-04-10',
};

function parseArgs(argv) {
  const args = { _: [] };
  argv.forEach(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) { args._.push(a); return; }
    args[m[1]] = m[2] === undefined ? true : m[2];
  });
  return args;
}

function espnDate(isoDate) {
  const d = new Date(isoDate);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Fetch games for a date range from ESPN.
 */
async function fetchGamesForDateRange(startDate, endDate, { logger = null } = {}) {
  const espn = new EspnProvider({ logger });
  const games = [];
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  const current = new Date(start);
  
  while (current <= end) {
    const dateStr = espnDate(current.toISOString());
    logger?.log?.('info', `Fetching scoreboard for ${dateStr}`);
    
    try {
      const scoreboard = await espn.getScoreboard('basketball', 'nba', { dates: dateStr });
      const events = scoreboard?.events || [];
      
      logger?.log?.('info', `Found ${events.length} games for ${dateStr}`);
      
      for (const event of events) {
        const comp = event.competitions?.[0];
        if (!comp) continue;
        
        const homeComp = comp.competitors?.find(c => c.homeAway === 'home');
        const awayComp = comp.competitors?.find(c => c.homeAway === 'away');
        if (!homeComp || !awayComp) continue;
        
        // Only include completed games
        if (comp.status?.type?.state !== 'post') continue;
        
        const score = (c) => {
          const v = c?.score?.value ?? c?.score?.displayValue;
          const n = v == null || v === '' ? NaN : parseFloat(v);
          return Number.isNaN(n) ? null : n;
        };
        
        const homeScore = score(homeComp);
        const awayScore = score(awayComp);
        if (homeScore == null || awayScore == null) continue;
        
        // Fetch detailed summary for odds and box scores
        const summary = await espn.getMatchSummary('basketball', 'nba', event.id);
        const odds = EspnProvider.extractBasketballOdds(summary);
        
        games.push({
          gameId: String(event.id),
          tipoff: event.date,
          league: 'nba',
          venue: comp.venue?.fullName || null,
          home: {
            teamId: String(homeComp.team?.id),
            name: homeComp.team?.displayName || null,
            score: homeScore,
            stats: EspnProvider.extractBasketballBoxScore(homeComp, awayComp),
          },
          away: {
            teamId: String(awayComp.team?.id),
            name: awayComp.team?.displayName || null,
            score: awayScore,
            stats: EspnProvider.extractBasketballBoxScore(awayComp, homeComp),
          },
          odds: odds ? {
            total: odds.overUnder,
            overOdds: odds.overOdds,
            underOdds: odds.underOdds,
            spread: odds.spread,
            homeOdds: odds.homeSpreadOdds,
            awayOdds: odds.awaySpreadOdds,
          } : null,
          closing: odds ? {
            total: odds.close?.total || odds.overUnder,
            overOdds: odds.close?.overOdds || odds.overOdds,
            underOdds: odds.close?.underOdds || odds.underOdds,
            spread: odds.close?.spread || odds.spread,
            homeOdds: odds.close?.homeMoneyLine || odds.homeSpreadOdds,
            awayOdds: odds.close?.awayMoneyLine || odds.awaySpreadOdds,
          } : null,
        });
      }
    } catch (err) {
      logger?.log?.('error', `Failed to fetch ${dateStr}: ${err.message}`);
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  return games;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seasons = (args.seasons || '2024').split(',').map(s => s.trim());
  const outFile = args.out || path.resolve(process.cwd(), 'data', 'nba-history.json');
  const maxGames = parseInt(args['max-games'] || '1000', 10);
  
  // Simple logger
  const logs = [];
  const logger = {
    log: (level, message, meta) => {
      logs.push({ level, message, meta });
      console.log(`[${level.toUpperCase()}] ${message}`, meta || '');
    },
  };
  
  logger.log('info', `Fetching NBA data for seasons: ${seasons.join(', ')}`);
  
  const allGames = [];
  
  for (const season of seasons) {
    const startDate = ESPN_BASE_SEASON_START[season] || `${season}-10-01`;
    const endDate = ESPN_BASE_SEASON_END[season] || `${parseInt(season) + 1}-04-15`;
    
    logger.log('info', `Fetching season ${season}: ${startDate} to ${endDate}`);
    
    const games = await fetchGamesForDateRange(startDate, endDate, { logger });
    logger.log('info', `Fetched ${games.length} games for season ${season}`);
    
    allGames.push(...games);
    
    if (allGames.length >= maxGames) {
      logger.log('info', `Reached max games limit ${maxGames}`);
      break;
    }
  }
  
  // Sort by tipoff
  allGames.sort((a, b) => new Date(a.tipoff) - new Date(b.tipoff));
  
  const dataset = {
    league: 'nba',
    games: allGames.slice(0, maxGames),
  };
  
  // Ensure output directory exists
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  fs.writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  logger.log('info', `Wrote ${dataset.games.length} games to ${outFile}`);
  
  // Summary
  logger.log('info', `Summary:`);
  logger.log('info', `  Total games: ${dataset.games.length}`);
  logger.log('info', `  With odds: ${dataset.games.filter(g => g.odds).length}`);
  logger.log('info', `  Date range: ${dataset.games[0]?.tipoff || 'N/A'} to ${dataset.games[dataset.games.length - 1]?.tipoff || 'N/A'}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fetch failed:', err?.stack || err?.message || err);
    process.exit(1);
  });
}

module.exports = { fetchGamesForDateRange };
